'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Flame,
  Fan,
  RotateCw,
  Gauge,
  Thermometer,
  Send,
  MessageSquare,
  Play,
  Square,
  CheckCircle2,
  AlertTriangle,
  Cpu,
  ArrowRight,
  ArrowDown,
  Info,
  ChevronRight,
  TrendingUp,
  Wind
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea
} from 'recharts';

// @ts-ignore
import { createRoasterSim } from './roasterSim';

// Monotonic counter for client-side message/audit ids (avoids impure Math.random in render).
let uidSeq = 0;

// Define TS Interfaces for Recipe Parameters and telemetry
interface RecipeParameters {
  profilePreset: string;
  batchSize: number;
  chargeTemp: number;
  targetDropTemp: number;
  burnerSetpoint: number;
  airflow: number;
  drumSpeed: number;
  totalRoastTime: string;
  targetRor: number;
}

type SignalKey = 'bean_temp_c' | 'drum_temp_c' | 'airflow_pct' | 'ror_c_per_min';

interface AnalysisStep {
  step_number: number;
  signal: SignalKey;
  narration: string;
  highlight_from_s: number;
  highlight_to_s: number;
  finding: string;
}

interface RootCause {
  cause: string;
  confidence: number;
  evidence: string;
  verification_step: string;
}

interface FaultBranch {
  intermediate_cause: string;
  confidence: number;
  root_causes: RootCause[];
}

interface Diagnosis {
  intro: string;
  analysis_steps: AnalysisStep[];
  fault_tree: FaultBranch[];
  most_likely_root_cause: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

interface FixStep {
  step_number: number;
  action: string;
  type: 'automatable' | 'manual';
  target_parameter: string;
  current_value: string;
  proposed_value: string;
  expected_effect: string;
  risk: 'low' | 'medium' | 'high';
  risk_note: string;
}

interface FixPlan {
  objective: string;
  steps: FixStep[];
  requires_human_approval: boolean;
  approval_summary: string;
  rollback_plan: string;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  operator: string;
  approval_summary: string;
  decision: 'APPROVED' | 'REJECTED';
  outcome: string;
}

type ChatKind =
  | 'text'
  | 'analyzing'
  | 'intro'
  | 'step'
  | 'fault_tree'
  | 'plan'
  | 'confirmation'
  | 'error';

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  kind: ChatKind;
  text?: string;
  step?: AnalysisStep;
  diagnosis?: Diagnosis;
  plan?: FixPlan;
  decided?: 'APPROVED' | 'REJECTED';
}

interface RoasterReading {
  bean_temp_c: number;
  drum_temp_c: number;
  exhaust_temp_c: number;
  airflow_pct: number;
  burner_pct: number;
  drum_rpm: number;
  ror_c_per_min: number;
  roast_phase: string;
  elapsed_s: number;
  scorch_index: number;
  status: string;
}

export default function ForemanDashboard() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<'roaster' | 'foreman'>('roaster');
  const [isRoastRunning, setIsRoastRunning] = useState(false);

  // Live simulation setup
  const simRef = useRef<any>(null);
  if (simRef.current === null) {
    simRef.current = createRoasterSim();
  }

  const [reading, setReading] = useState<RoasterReading | null>(null);
  const [history, setHistory] = useState<RoasterReading[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const [tickGlow, setTickGlow] = useState(false);
  const tickTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Suggested questions (human-initiated investigation triggers)
  const SUGGESTED_QUESTIONS = [
    "Investigate the current anomaly",
    "Why is ROR rising?",
    "What should I do?"
  ];

  // Recipe Parameters States
  const [recipe, setRecipe] = useState<RecipeParameters>({
    profilePreset: 'Full City',
    batchSize: 12,
    chargeTemp: 200,
    targetDropTemp: 205,
    burnerSetpoint: 80,
    airflow: 55,
    drumSpeed: 60,
    totalRoastTime: '11:30',
    targetRor: 12
  });

  // Chat Feed State
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      sender: 'assistant',
      timestamp: '15:23:00',
      kind: 'text',
      text: "Foreman is monitoring the roast. After a fault, send an investigation message (e.g. \"investigate the anomaly\") and I will walk you through the evidence."
    }
  ]);

  // Investigation pipeline state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<FixPlan | null>(null);
  const [pendingDiagnosis, setPendingDiagnosis] = useState<Diagnosis | null>(null);
  const [planMsgId, setPlanMsgId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

  // Chart highlight bands keyed by signal (recharts ReferenceArea), plus the
  // currently narrated signal so the matching chart can glow.
  const [highlightBands, setHighlightBands] = useState<Record<string, { from: number; to: number }[]>>({});
  const [activeSignal, setActiveSignal] = useState<SignalKey | null>(null);

  // Latest reading kept in a ref so async pipeline steps read live setpoints
  // without being captured stale in a closure.
  const readingRef = useRef<RoasterReading | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Prevent SSR Hydration Mismatch for charts and timestamps
  useEffect(() => {
    const timer = setTimeout(() => {
      setMounted(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Scroll to bottom of chat
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Keep a ref to the latest reading for async pipeline steps.
  useEffect(() => {
    readingRef.current = reading;
  }, [reading]);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (tickTimeoutRef.current) {
        clearTimeout(tickTimeoutRef.current);
      }
    };
  }, []);

  // Format mm:ss displays
  const formatElapsed = (sec: number | undefined | null) => {
    if (sec === undefined || sec === null) return "--:--";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const mm = m < 10 ? `0${m}` : `${m}`;
    const ss = s < 10 ? `0${s}` : `${s}`;
    return `${mm}:${ss}`;
  };

  // Centralized status badge styling helper
  const getStatusBadgeStyle = (status: string | undefined | null) => {
    if (!reading) {
      return {
        text: 'text-slate-500 border-slate-700/30 bg-slate-800/10',
        dot: 'bg-slate-500',
        label: 'IDLE'
      };
    }
    const currentStatus = status || 'NORMAL';
    
    switch (currentStatus) {
      case 'WARNING':
        return {
          text: 'text-amber-500 border-amber-500/30 bg-amber-950/20',
          dot: 'bg-amber-500 animate-pulse',
          label: 'WARNING'
        };
      case 'FAULT':
        return {
          text: 'text-red-500 border-red-500/30 bg-red-950/20',
          dot: 'bg-red-500 animate-ping',
          label: 'FAULT'
        };
      case 'RECOVERING':
        return {
          text: 'text-amber-400 border-amber-400/30 bg-amber-950/10',
          dot: 'bg-amber-400 animate-pulse',
          label: 'RECOVERING'
        };
      case 'RECOVERED':
        return {
          text: 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20',
          dot: 'bg-emerald-400',
          label: 'RECOVERED'
        };
      case 'NORMAL':
      default:
        return {
          text: 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20',
          dot: 'bg-[#10b981]',
          label: 'NORMAL'
        };
    }
  };

  // Centralized styling for Process Flow cards (BFD)
  const getBlockClasses = (blockId: string) => {
    const status = reading?.status;
    const isAnomalousActive = status === 'WARNING' || status === 'FAULT';
    
    if (isAnomalousActive) {
      const isCulprit = blockId === 'air-damper' || blockId === 'drum-roaster';
      if (isCulprit) {
        if (status === 'WARNING') {
          return {
            border: 'border-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.25)] bg-amber-950/25',
            glow: 'bg-amber-500'
          };
        } else { // FAULT
          return {
            border: 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.35)] bg-red-950/25 animate-pulse',
            glow: 'bg-red-500'
          };
        }
      }
    }
    
    // Default config
    if (blockId === 'drum-roaster') {
      return {
        border: 'border-[#3b82f6]/80 shadow-[0_0_15px_rgba(59,130,246,0.15)] bg-[#111418]',
        glow: 'bg-[#10b981]'
      };
    }
    
    return {
      border: 'border-[#334155] bg-[#111418] hover:border-slate-500',
      glow: 'bg-[#10b981]'
    };
  };

  // Toggle roast tick operations
  const handleToggleRoast = () => {
    if (isRoastRunning) {
      // Pause
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setIsRoastRunning(false);
    } else {
      setIsRoastRunning(true);
      
      const runTick = () => {
        if (simRef.current) {
          const r = simRef.current.tick(1);
          setReading(r);
          setHistory(h => [...h.slice(-59), r]);
          
          setTickGlow(true);
          if (tickTimeoutRef.current) clearTimeout(tickTimeoutRef.current);
          tickTimeoutRef.current = setTimeout(() => {
            setTickGlow(false);
          }, 300);
        }
      };

      // Tick immediately
      runTick();

      const intervalVal = setInterval(runTick, 1000);
      intervalRef.current = intervalVal;
    }
  };

  // Reset simulator
  const handleResetSim = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (tickTimeoutRef.current) {
      clearTimeout(tickTimeoutRef.current);
    }
    setIsRoastRunning(false);
    simRef.current = createRoasterSim();
    setReading(null);
    readingRef.current = null;
    setHistory([]);
    setTickGlow(false);
    // Clear any in-flight investigation / highlights / gate.
    setHighlightBands({});
    setActiveSignal(null);
    setPendingPlan(null);
    setPendingDiagnosis(null);
    setPlanMsgId(null);
    setRejecting(false);
    setIsAnalyzing(false);
  };

  // Handle recipe input edits
  const handleRecipeChange = <K extends keyof RecipeParameters>(
    key: K,
    value: RecipeParameters[K]
  ) => {
    setRecipe(prev => ({ ...prev, [key]: value }));
  };

  // --- Investigation pipeline helpers ---

  const nowTime = () =>
    new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

  const uid = () => `m-${(uidSeq++).toString(36)}`;

  const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

  const pushMessage = (msg: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }) => {
    const id = msg.id ?? uid();
    setMessages(prev => [...prev, { ...msg, id, timestamp: nowTime() }]);
    return id;
  };

  // Build the frozen telemetry window from the REAL recent readings.
  const buildTelemetryWindow = () =>
    history.slice(-12).map(r => ({
      elapsed_s: r.elapsed_s,
      bean_temp_c: r.bean_temp_c,
      drum_temp_c: r.drum_temp_c,
      exhaust_temp_c: r.exhaust_temp_c,
      airflow_pct: r.airflow_pct,
      burner_pct: r.burner_pct,
      drum_rpm: r.drum_rpm,
      ror_c_per_min: r.ror_c_per_min,
      roast_phase: r.roast_phase
    }));

  async function callForeman(payload: Record<string, unknown>) {
    const res = await fetch('/api/foreman', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error(json.error || `Request failed (${res.status}).`);
    }
    return json.data;
  }

  // Run the gated remediation planner (also used to re-plan after a rejection).
  async function runPlan(diagnosis: Diagnosis, rejectionReason?: string) {
    const r = readingRef.current;
    const setpoints = {
      burner_pct: r?.burner_pct ?? recipe.burnerSetpoint,
      airflow_pct: r?.airflow_pct ?? recipe.airflow,
      drum_rpm: r?.drum_rpm ?? recipe.drumSpeed
    };
    try {
      const plan = (await callForeman({
        stage: 'plan',
        diagnosis,
        setpoints,
        ...(rejectionReason ? { rejection_reason: rejectionReason } : {})
      })) as FixPlan;

      const id = pushMessage({ sender: 'assistant', kind: 'plan', plan });
      setPendingPlan(plan);
      setPlanMsgId(id);
    } catch (err) {
      pushMessage({
        sender: 'assistant',
        kind: 'error',
        text: `Foreman could not produce a remediation plan: ${
          err instanceof Error ? err.message : 'unknown error'
        }`
      });
    }
  }

  // Full human-initiated investigation: snapshot -> diagnose (narrated) -> plan.
  async function runInvestigation(userText: string) {
    const r = readingRef.current;
    const telemetry = buildTelemetryWindow();

    if (!r || telemetry.length === 0) {
      pushMessage({
        sender: 'assistant',
        kind: 'error',
        text: 'No live telemetry yet. Start the roast (Run Roast) so I have data to analyze.'
      });
      return;
    }

    setIsAnalyzing(true);
    // Clear any stale highlights / pending gate from a previous run.
    setHighlightBands({});
    setActiveSignal(null);
    setPendingPlan(null);
    setPendingDiagnosis(null);
    setPlanMsgId(null);
    setRejecting(false);

    const analyzingId = pushMessage({ sender: 'assistant', kind: 'analyzing' });

    const anomaly =
      `Operator message: "${userText}". ` +
      `Current status flagged as ${r.status}. ` +
      `Latest reading at t=${r.elapsed_s}s: bean_temp_c=${r.bean_temp_c}, drum_temp_c=${r.drum_temp_c}, ` +
      `exhaust_temp_c=${r.exhaust_temp_c}, airflow_pct=${r.airflow_pct}, burner_pct=${r.burner_pct}, ` +
      `drum_rpm=${r.drum_rpm}, ror_c_per_min=${r.ror_c_per_min}, roast_phase=${r.roast_phase}.`;

    let diagnosis: Diagnosis;
    try {
      diagnosis = (await callForeman({ stage: 'diagnose', anomaly, telemetry })) as Diagnosis;
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== analyzingId));
      pushMessage({
        sender: 'assistant',
        kind: 'error',
        text: `Foreman's diagnosis failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }. Check the Gemini key in .env.local and try again.`
      });
      setIsAnalyzing(false);
      return;
    }

    // Remove the "analyzing" placeholder, then narrate.
    setMessages(prev => prev.filter(m => m.id !== analyzingId));
    setPendingDiagnosis(diagnosis);

    if (diagnosis.intro) {
      pushMessage({ sender: 'assistant', kind: 'intro', text: diagnosis.intro });
      await sleep(500);
    }

    // Reveal analysis steps one at a time; light up the matching chart per step.
    const steps = Array.isArray(diagnosis.analysis_steps) ? diagnosis.analysis_steps : [];
    for (const step of steps) {
      pushMessage({ sender: 'assistant', kind: 'step', step });
      if (step.signal) {
        setActiveSignal(step.signal);
        setHighlightBands(prev => ({
          ...prev,
          [step.signal]: [
            ...(prev[step.signal] ?? []),
            { from: step.highlight_from_s, to: step.highlight_to_s }
          ]
        }));
      }
      await sleep(600);
    }
    setActiveSignal(null);

    // Render the fault tree + most-likely root cause + severity.
    pushMessage({ sender: 'assistant', kind: 'fault_tree', diagnosis });
    await sleep(400);

    // Call 2 runs immediately after diagnosis.
    await runPlan(diagnosis);
    setIsAnalyzing(false);
  }

  // Submit User Message — any send kicks off the investigation pipeline.
  const handleSendMessage = (textToSend?: string) => {
    const rawMsgText = (textToSend || chatInput).trim();
    if (!rawMsgText) return;
    if (isAnalyzing) return; // ignore while a pipeline is mid-flight

    pushMessage({ sender: 'user', kind: 'text', text: rawMsgText });
    if (!textToSend) setChatInput('');

    void runInvestigation(rawMsgText);
  };

  // --- Approval gate handlers ---

  const handleApprove = () => {
    if (!pendingPlan) return;
    const approved = pendingPlan;

    // Only NOW does anything touch the simulator.
    if (simRef.current) simRef.current.applyFix();

    if (planMsgId) {
      setMessages(prev =>
        prev.map(m => (m.id === planMsgId ? { ...m, decided: 'APPROVED' } : m))
      );
    }

    pushMessage({
      sender: 'assistant',
      kind: 'confirmation',
      text: `Approved. Applying corrective setpoints now — raising airflow and cutting burner. Telemetry should normalize over the next ticks (status will move to RECOVERING, then RECOVERED). Rollback on standby: ${approved.rollback_plan}`
    });

    setAuditLog(prev => [
      ...prev,
      {
        id: uid(),
        timestamp: nowTime(),
        operator: 'Operator A',
        approval_summary: approved.approval_summary,
        decision: 'APPROVED',
        outcome: 'telemetry recovered'
      }
    ]);

    // Bands fade once the fix is authorized.
    setHighlightBands({});
    setActiveSignal(null);
    setPendingPlan(null);
    setPlanMsgId(null);
    setRejecting(false);
  };

  const handleRejectSubmit = async () => {
    if (!pendingPlan || !pendingDiagnosis) return;
    const reason = rejectReason.trim() || 'No reason provided.';
    const rejected = pendingPlan;

    if (planMsgId) {
      setMessages(prev =>
        prev.map(m => (m.id === planMsgId ? { ...m, decided: 'REJECTED' } : m))
      );
    }

    setAuditLog(prev => [
      ...prev,
      {
        id: uid(),
        timestamp: nowTime(),
        operator: 'Operator A',
        approval_summary: rejected.approval_summary,
        decision: 'REJECTED',
        outcome: 're-planned'
      }
    ]);

    pushMessage({ sender: 'user', kind: 'text', text: `Reject — ${reason}` });

    setRejecting(false);
    setRejectReason('');
    setPendingPlan(null);
    setPlanMsgId(null);

    // Re-plan with the operator's reason.
    setIsAnalyzing(true);
    await runPlan(pendingDiagnosis, reason);
    setIsAnalyzing(false);
  };

  // --- Chart highlight rendering ---

  const bandsFor = (signal: SignalKey) =>
    (highlightBands[signal] ?? []).map((b, i) => (
      <ReferenceArea
        key={`${signal}-${i}`}
        x1={b.from}
        x2={b.to}
        fill="#f59e0b"
        fillOpacity={0.14}
        stroke="#f59e0b"
        strokeOpacity={0.35}
        ifOverflow="extendDomain"
      />
    ));

  const cardGlow = (signal: SignalKey) =>
    activeSignal === signal
      ? 'border-amber-500 shadow-[0_0_18px_rgba(245,158,11,0.35)]'
      : 'border-[#1e293b]';

  const confidencePct = (c: number) => `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;

  const severityBadge = (sev: Diagnosis['severity']) => {
    switch (sev) {
      case 'critical':
        return 'text-red-400 border-red-500/40 bg-red-950/30';
      case 'high':
        return 'text-orange-400 border-orange-500/40 bg-orange-950/30';
      case 'medium':
        return 'text-amber-400 border-amber-500/40 bg-amber-950/30';
      default:
        return 'text-emerald-400 border-emerald-500/40 bg-emerald-950/30';
    }
  };

  const riskColor = (risk: FixStep['risk']) => {
    switch (risk) {
      case 'high':
        return 'text-red-400 border-red-500/40 bg-red-950/30';
      case 'medium':
        return 'text-amber-400 border-amber-500/40 bg-amber-950/30';
      default:
        return 'text-emerald-400 border-emerald-500/40 bg-emerald-950/30';
    }
  };

  const SIGNAL_LABEL: Record<SignalKey, string> = {
    bean_temp_c: 'bean_temp_c',
    drum_temp_c: 'drum_temp_c',
    airflow_pct: 'airflow_pct',
    ror_c_per_min: 'ror_c_per_min'
  };

  // --- Rich chat message bodies ---

  const renderStepBody = (step: AnalysisStep) => (
    <div className="text-xs">
      <div className="flex items-center space-x-2 mb-1.5">
        <span className="font-mono text-[9px] font-bold text-[#3b82f6] bg-[rgba(59,130,246,0.12)] border border-[#3b82f6]/30 px-1.5 py-0.5 rounded-sm">
          STEP {step.step_number}
        </span>
        <span className="font-mono text-[9px] text-amber-400 bg-amber-950/30 border border-amber-500/30 px-1.5 py-0.5 rounded-sm">
          {SIGNAL_LABEL[step.signal] ?? step.signal} · {formatElapsed(step.highlight_from_s)}–{formatElapsed(step.highlight_to_s)}
        </span>
      </div>
      <p className="text-slate-200 leading-relaxed">{step.narration}</p>
      <p className="mt-1.5 text-[11px] text-emerald-300/90 border-l-2 border-emerald-500/40 pl-2">
        {step.finding}
      </p>
    </div>
  );

  const renderFaultTreeBody = (d: Diagnosis) => (
    <div className="text-xs space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase font-bold tracking-widest text-slate-400">Fault Tree</span>
        <span className={`text-[9px] uppercase font-bold tracking-widest px-2 py-0.5 border rounded-sm ${severityBadge(d.severity)}`}>
          {d.severity}
        </span>
      </div>

      <div className="space-y-2.5">
        {(d.fault_tree ?? []).map((branch, bi) => (
          <div key={bi} className="border border-[#1e293b] rounded-sm p-2.5 bg-[#0a0c0f]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-slate-200 font-semibold">{branch.intermediate_cause}</span>
              <span className="font-mono text-[9px] text-slate-400 ml-2 shrink-0">{confidencePct(branch.confidence)}</span>
            </div>
            <div className="h-1 w-full bg-[#1e293b] rounded-sm overflow-hidden mb-2">
              <div className="h-full bg-[#3b82f6]" style={{ width: confidencePct(branch.confidence) }} />
            </div>
            <div className="space-y-2 pl-2 border-l border-[#1e293b]">
              {(branch.root_causes ?? []).map((rc, ri) => (
                <div key={ri} className="text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300 font-medium">{rc.cause}</span>
                    <span className="font-mono text-[9px] text-slate-500 ml-2 shrink-0">{confidencePct(rc.confidence)}</span>
                  </div>
                  <p className="text-slate-500 mt-0.5"><span className="text-slate-400">Evidence:</span> {rc.evidence}</p>
                  <p className="text-slate-500 mt-0.5"><span className="text-slate-400">Verify:</span> {rc.verification_step}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="border border-amber-500/30 bg-amber-950/20 rounded-sm p-2.5">
        <span className="text-[9px] uppercase font-bold tracking-widest text-amber-400">Most Likely Root Cause</span>
        <p className="text-slate-100 mt-1">{d.most_likely_root_cause}</p>
      </div>

      {d.summary && <p className="text-slate-400 leading-relaxed">{d.summary}</p>}
    </div>
  );

  const renderPlanBody = (msg: ChatMessage) => {
    const plan = msg.plan!;
    const isActiveGate = pendingPlan !== null && msg.id === planMsgId && !msg.decided;
    return (
      <div className="text-xs space-y-3">
        <div>
          <span className="text-[9px] uppercase font-bold tracking-widest text-[#3b82f6]">Proposed Fix Plan</span>
          <p className="text-slate-200 mt-1">{plan.objective}</p>
        </div>

        <div className="space-y-2">
          {(plan.steps ?? []).map((s) => (
            <div key={s.step_number} className="border border-[#1e293b] rounded-sm p-2.5 bg-[#0a0c0f]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-slate-200 font-semibold">{s.step_number}. {s.action}</span>
                <div className="flex items-center space-x-1.5 shrink-0 ml-2">
                  <span className={`font-mono text-[8px] uppercase px-1.5 py-0.5 rounded-sm border ${
                    s.type === 'automatable'
                      ? 'text-[#3b82f6] border-[#3b82f6]/40 bg-[rgba(59,130,246,0.1)]'
                      : 'text-slate-400 border-slate-600/40 bg-slate-800/30'
                  }`}>{s.type}</span>
                  <span className={`font-mono text-[8px] uppercase px-1.5 py-0.5 rounded-sm border ${riskColor(s.risk)}`}>
                    {s.risk} risk
                  </span>
                </div>
              </div>
              <div className="font-mono text-[10px] text-slate-400">
                {s.target_parameter}: <span className="text-slate-300">{s.current_value}</span>
                {' → '}
                <span className="text-emerald-400">{s.proposed_value}</span>
              </div>
              <p className="text-[10px] text-slate-500 mt-1">{s.expected_effect}</p>
              {s.risk_note && <p className="text-[10px] text-slate-600 mt-0.5 italic">{s.risk_note}</p>}
            </div>
          ))}
        </div>

        <p className="text-[10px] text-slate-500"><span className="text-slate-400">Rollback:</span> {plan.rollback_plan}</p>

        {/* Approval gate */}
        <div className="border border-amber-500/40 bg-amber-950/20 rounded-sm p-3">
          <div className="flex items-start space-x-2 mb-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-slate-100 font-medium">{plan.approval_summary}</p>
          </div>

          {msg.decided ? (
            <div className={`text-[10px] font-mono uppercase tracking-widest font-bold ${
              msg.decided === 'APPROVED' ? 'text-emerald-400' : 'text-red-400'
            }`}>
              {msg.decided === 'APPROVED' ? '✓ Approved by Operator A' : '✕ Rejected by Operator A'}
            </div>
          ) : isActiveGate ? (
            rejecting ? (
              <div className="space-y-2">
                <input
                  id="reject-reason-input"
                  type="text"
                  autoFocus
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRejectSubmit(); }}
                  placeholder="One-line reason for rejection…"
                  className="w-full bg-[#0a0c0f] border border-[#334155] text-slate-200 text-[11px] rounded-sm p-2 outline-none focus:border-red-500"
                />
                <div className="flex items-center space-x-2">
                  <button
                    id="btn-reject-confirm"
                    onClick={() => void handleRejectSubmit()}
                    className="flex-1 py-2 bg-[#ef4444] hover:bg-[#dc2626] text-white text-[10px] uppercase font-bold tracking-widest rounded-sm transition-all cursor-pointer"
                  >
                    Submit Rejection
                  </button>
                  <button
                    onClick={() => { setRejecting(false); setRejectReason(''); }}
                    className="px-3 py-2 border border-slate-700 hover:border-slate-500 text-slate-300 text-[10px] uppercase font-bold tracking-widest rounded-sm transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <button
                  id="btn-approve-fix"
                  onClick={handleApprove}
                  className="flex-1 py-2.5 flex items-center justify-center space-x-1.5 bg-[#10b981] hover:bg-[#059669] text-white text-[10px] uppercase font-bold tracking-widest rounded-sm transition-all cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Approve</span>
                </button>
                <button
                  id="btn-reject-fix"
                  onClick={() => setRejecting(true)}
                  className="flex-1 py-2.5 flex items-center justify-center space-x-1.5 bg-[#ef4444] hover:bg-[#dc2626] text-white text-[10px] uppercase font-bold tracking-widest rounded-sm transition-all cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-white" />
                  <span>Reject</span>
                </button>
              </div>
            )
          ) : (
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Superseded</div>
          )}
        </div>
      </div>
    );
  };

  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#07090c] text-[#8e9cae] flex items-center justify-center font-mono" id="loading-fallback">
        <div className="flex flex-col items-center space-y-3">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs uppercase tracking-widest text-[#526477]">Initializing SCADA Systems...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen max-h-screen w-full bg-[#0a0c0f] text-[#e2e8f0] overflow-hidden select-none" id="foreman-app-container">
      
      {/* COMPACT SCADA TOP BAR */}
      <header className="flex items-center justify-between px-5 h-12 bg-[#0d1014] border-b border-[#1e293b]" id="scada-topbar">
        <div className="flex items-center space-x-3.5">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 bg-[#3b82f6] rounded-sm animate-pulse shadow-[0_0_10px_rgba(59,130,246,0.3)]"></span>
            <h1 className="font-sans font-extrabold text-white text-sm tracking-widest uppercase">Foreman</h1>
          </div>
          <span className="h-4 w-[1px] bg-[#1d2430]"></span>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">
            AI shop-floor engineer — <span className="text-slate-400">human stays in command</span>
          </p>
        </div>

        <div className="flex items-center space-x-4 font-mono text-[11px]" id="topbar-status-panel">
          {/* Action Simulation Controls */}
          <div className="flex items-center space-x-2" id="sim-control-topbar">
            <button
              id="btn-inject-fault"
              disabled={!isRoastRunning}
              onClick={() => {
                if (simRef.current) {
                  simRef.current.injectFault('scorch');
                }
              }}
              className={`px-3 py-1 border text-[10px] uppercase font-bold tracking-wider rounded-sm transition-all cursor-pointer ${
                isRoastRunning
                  ? 'border-red-500/50 hover:bg-red-950/40 text-red-400 bg-red-950/20'
                  : 'border-[#1e293b] text-slate-600 bg-transparent cursor-not-allowed opacity-40'
              }`}
            >
              Inject Fault
            </button>

            <button
              id="btn-apply-fix-debug"
              disabled={!isRoastRunning}
              onClick={() => {
                if (simRef.current) {
                  simRef.current.applyFix();
                }
              }}
              className={`px-3 py-1 border text-[10px] uppercase font-bold tracking-wider rounded-sm transition-all cursor-pointer ${
                isRoastRunning
                  ? 'border-amber-500/50 hover:bg-amber-950/40 text-amber-400 bg-amber-950/20'
                  : 'border-[#1e293b] text-slate-600 bg-transparent cursor-not-allowed opacity-40'
              }`}
            >
              Apply Fix (debug)
            </button>

            <button
              id="btn-reset-sim"
              onClick={handleResetSim}
              className="px-3 py-1 border border-slate-700 hover:border-slate-500 hover:bg-slate-800 text-slate-300 text-[10px] uppercase font-bold tracking-wider rounded-sm transition-all cursor-pointer bg-[#111418]"
            >
              Reset
            </button>
          </div>

          <span className="h-4 w-[1px] bg-[#1d2430]"></span>

          <div className="flex items-center bg-[#111418] px-3 py-1 border border-[#1e293b] rounded-sm space-x-2">
            <span className="text-slate-500 uppercase">Station:</span>
            <span className="text-[#e2e8f0]">#01-DRUM-15</span>
          </div>
          <div className="flex items-center bg-[#111418] px-3 py-1 border border-[#1e293b] rounded-sm space-x-2">
            <span className="w-2 h-2 rounded-full bg-[#10b981] shadow-[0_0_8px_#10b981]"></span>
            <span className="text-emerald-400 uppercase tracking-widest font-bold text-[10px]">Roaster Online</span>
          </div>
        </div>
      </header>

      {/* TABS SELECTOR BOX */}
      <div className="bg-[#0a0c0f] px-5 py-0 flex items-center justify-between border-b border-[#1e293b] h-11" id="scada-tabs-container">
        <div className="flex h-full items-stretch" id="tab-btns">
          <button
            id="tab-btn-roaster"
            onClick={() => setActiveTab('roaster')}
            className={`flex items-center space-x-2 px-5 text-[11px] font-bold uppercase tracking-widest h-full transition-all cursor-pointer ${
              activeTab === 'roaster'
                ? 'border-b-2 border-[#3b82f6] text-white bg-[rgba(59,130,246,0.1)]'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Gauge className="w-3.5 h-3.5" />
            <span>Roaster Control</span>
          </button>
          <button
            id="tab-btn-foreman"
            onClick={() => setActiveTab('foreman')}
            className={`flex items-center space-x-2 px-5 text-[11px] font-bold uppercase tracking-widest h-full transition-all cursor-pointer ${
              activeTab === 'foreman'
                ? 'border-b-2 border-[#3b82f6] text-white bg-[rgba(59,130,246,0.1)]'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Foreman AI</span>
          </button>
        </div>

        {/* Dynamic global run status tag */}
        <div className="flex items-center space-x-3 font-mono text-xs text-slate-400" id="global-run-indicator">
          {isRoastRunning ? (
            <span className="flex items-center bg-amber-950/40 text-amber-500 border border-amber-900/40 px-3 py-1 rounded-sm text-[10px] uppercase font-bold animate-pulse" id="live-run-tag">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-2 animate-ping"></span>
              Roast running… {reading ? `(${formatElapsed(reading.elapsed_s)})` : ""}
            </span>
          ) : (
            <span className="flex items-center bg-[#111418] text-slate-500 border border-[#1e293b] px-3 py-1 rounded-sm text-[10px] uppercase" id="live-standby-tag">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 mr-2"></span>
              STANDBY
            </span>
          )}
        </div>
      </div>

      {/* MAIN VIEW AREA */}
      <main className="flex-1 overflow-hidden" id="main-scada-viewport">
        {activeTab === 'roaster' ? (
          
          /* TAB 1: ROASTER CONTROL DESIGN */
          <div className="flex h-full w-full overflow-hidden" id="roaster-view-grid">
            
            {/* LEFT / CENTER: PROCESS FLOW WORKSPACE */}
            <div className="flex-1 h-full bg-[#0a0c0f] p-6 overflow-auto flex flex-col justify-between border-r border-[#1e293b]" id="process-flow-area">
              
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500 font-mono font-bold">Flow Graphic</span>
                    <span className="text-xs font-semibold text-slate-200">Drum Roaster System Diagram</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 bg-[#111418] px-2 py-0.5 border border-[#1e293b] rounded-sm">
                    SYS.V_2026.06
                  </span>
                </div>
                <hr className="border-[#1e293b]/20" />
              </div>

              {/* Blueprint Grid Layout */}
              <div 
                className="flex-1 flex flex-col justify-center items-center relative rounded-sm border border-[#1e293b] p-6 blueprint-grid" 
                id="blueprint-flow-graphics"
              >
                
                {/* Horizontal flow track container */}
                <div className="w-full max-w-4xl flex flex-col space-y-12 relative" id="blueprint-track">
                  
                  {/* MAIN COFFEE PROCESSING FLIGHTPATH */}
                  <div className="flex items-center justify-between w-full relative z-10" id="main-flightpath">
                    
                    {/* (1) Green Bean Hopper */}
                    <div className="flex flex-col items-center" id="block-hopper-wrapper">
                      <div className="relative group bg-[#111418] border border-[#334155] hover:border-slate-500 w-32 rounded-sm p-2.5 shadow-md flex flex-col h-24 justify-between transition-all" id="block-hopper">
                        <div className="absolute top-1 left-2 flex items-center space-x-1.5">
                          <span className="w-1.5 h-1.5 bg-[#10b981] rounded-full"></span>
                          <span className="text-[8px] text-slate-500 uppercase font-bold tracking-wider">HPR-01</span>
                        </div>
                        <div className="mt-4 text-center">
                          <p className="text-[10px] uppercase font-semibold text-slate-300">Green Bean Hopper</p>
                        </div>
                        <div className="mt-2 text-center font-mono text-xs text-emerald-400 bg-[#0a0c0f] py-0.5 rounded-sm border border-[#1e293b]">
                          {recipe.batchSize.toFixed(2)} kg
                        </div>
                      </div>
                    </div>

                    {/* Flow arrow */}
                    <div className="text-slate-700/80 flex flex-col items-center flex-1 cursor-default" id="arrow-hopper-charge">
                      <ArrowRight className="w-4 h-4 text-slate-600 animate-pulse" />
                    </div>

                    {/* (2) Charge Gate */}
                    <div className="flex flex-col items-center" id="block-charge-wrapper">
                      <div className="relative bg-[#111418] border border-[#334155] hover:border-slate-500 w-28 rounded-sm p-2.5 shadow-md flex flex-col h-24 justify-between transition-all" id="block-charge">
                        <div className="absolute top-1 left-2 flex items-center space-x-1.5">
                          <span className="w-1.5 h-1.5 bg-[#10b981] rounded-full"></span>
                          <span className="text-[8px] text-slate-500 uppercase font-bold tracking-wider">CHG-02</span>
                        </div>
                        <div className="mt-4 text-center">
                          <p className="text-[10px] uppercase font-semibold text-slate-300">Charge Gate</p>
                        </div>
                        <div className="mt-2 text-center font-mono text-xs text-emerald-400 bg-[#0a0c0f] py-0.5 rounded-sm border border-[#1e293b]">
                          {recipe.chargeTemp}°C Limit
                        </div>
                      </div>
                    </div>

                    {/* Flow arrow */}
                    <div className="text-slate-700/80 flex flex-col items-center flex-1" id="arrow-charge-drum">
                      <ArrowRight className="w-4 h-4 text-slate-600 animate-pulse" />
                    </div>

                    {/* (3) Drum Roaster (Highlight centerpiece layout) */}
                    <div className="flex flex-col items-center" id="block-drum-wrapper">
                      <div className={`relative w-44 rounded-sm p-3 flex flex-col h-28 justify-between transition-all border-2 ${getBlockClasses('drum-roaster').border}`} id="block-drum">
                        <div className="absolute top-1.5 left-2 flex items-center space-x-1.5">
                          <span className={`w-2 h-2 rounded-full animate-ping ${
                            reading?.status === 'FAULT' ? 'bg-red-500' : reading?.status === 'WARNING' ? 'bg-amber-500' : 'bg-[#10b981]'
                          }`}></span>
                          <span className={`text-[8px] font-bold uppercase tracking-widest font-mono ${
                            reading?.status === 'FAULT' ? 'text-red-400' : reading?.status === 'WARNING' ? 'text-amber-400' : 'text-[#3b82f6]'
                          }`}>DRUM-PRIMARY</span>
                        </div>
                        <div className="mt-5 text-center">
                          <p className={`text-[11px] uppercase font-bold tracking-wider ${
                            reading?.status === 'FAULT' ? 'text-red-300' : reading?.status === 'WARNING' ? 'text-amber-200' : 'text-slate-100'
                          }`}>Drum Roaster</p>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-1.5" id="drum-measurements">
                          <div className="bg-[#0a0c0f] p-1 rounded-sm text-center border border-[#1e293b]">
                            <span className="block text-[7px] text-slate-500 uppercase font-mono">Bean</span>
                            <span className={`text-[11px] font-mono font-bold ${
                              reading?.status === 'FAULT' ? 'text-red-400' : reading?.status === 'WARNING' ? 'text-amber-400' : 'text-emerald-400'
                            }`}>{reading ? `${reading.bean_temp_c}°C` : "--"}</span>
                          </div>
                          <div className="bg-[#0a0c0f] p-1 rounded-sm text-center border border-[#1e293b]">
                            <span className="block text-[7px] text-slate-500 uppercase font-mono">Drum</span>
                            <span className={`text-[11px] font-mono font-bold ${
                              reading?.status === 'FAULT' ? 'text-red-400' : reading?.status === 'WARNING' ? 'text-amber-400' : 'text-emerald-400'
                            }`}>{reading ? `${reading.drum_temp_c}°C` : "--"}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Flow arrow */}
                    <div className="text-slate-700/80 flex flex-col items-center flex-1" id="arrow-drum-cyclone">
                      <ArrowRight className="w-4 h-4 text-slate-600 animate-pulse" />
                    </div>

                    {/* (4) Cyclone Chaff Collector */}
                    <div className="flex flex-col items-center" id="block-cyclone-wrapper">
                      <div className="relative bg-[#111418] border border-[#334155] hover:border-slate-500 w-32 rounded-sm p-2.5 shadow-md flex flex-col h-24 justify-between transition-all" id="block-cyclone">
                        <div className="absolute top-1 left-2 flex items-center space-x-1.5">
                          <span className="w-1.5 h-1.5 bg-[#10b981] rounded-full"></span>
                          <span className="text-[8px] text-slate-500 uppercase font-bold tracking-wider">CYC-04</span>
                        </div>
                        <div className="mt-4 text-center">
                          <p className="text-[10px] uppercase font-semibold text-slate-300">Cyclone Collector</p>
                        </div>
                        <div className="mt-2 text-center font-mono text-xs text-emerald-400 bg-[#0a0c0f] py-0.5 rounded-sm border border-[#1e293b]">
                          Chaff: 98.4%
                        </div>
                      </div>
                    </div>

                    {/* Flow arrow */}
                    <div className="text-slate-700/80 flex flex-col items-center flex-1" id="arrow-cyclone-exhaust">
                      <ArrowRight className="w-4 h-4 text-slate-600 animate-pulse" />
                    </div>

                    {/* (5) Exhaust Stack */}
                    <div className="flex flex-col items-center" id="block-exhaust-wrapper">
                      <div className="relative bg-[#111418] border border-[#334155] hover:border-slate-500 w-28 rounded-sm p-2.5 shadow-md flex flex-col h-24 justify-between transition-all" id="block-exhaust">
                        <div className="absolute top-1 left-2 flex items-center space-x-1.5">
                          <span className="w-1.5 h-1.5 bg-[#10b981] rounded-full"></span>
                          <span className="text-[8px] text-slate-500 uppercase font-bold tracking-wider">EXT-05</span>
                        </div>
                        <div className="mt-4 text-center">
                          <p className="text-[10px] uppercase font-semibold text-slate-300">Exhaust Stack</p>
                        </div>
                        <div className="mt-2 text-center font-mono text-xs text-emerald-400 bg-[#0a0c0f] py-0.5 rounded-sm border border-[#1e293b]">
                          {reading ? `${reading.exhaust_temp_c.toFixed(1)}°C` : "--"}
                        </div>
                      </div>
                    </div>

                  </div>

                  {/* SECONDARY FEED CONNECTIONS (GRID OVERLAYS) */}
                  <div className="grid grid-cols-4 gap-4 w-full relative z-0" id="secondary-structures">
                    
                    {/* Burner Block feeding into Drum (Placed near bottom center) */}
                    <div className="flex flex-col items-center relative" id="burner-connector-area">
                      {/* Gas feed line representation */}
                      <div className="absolute top-[-48px] left-[50%] h-[48px] w-[1px] border-l-2 border-dotted border-slate-800"></div>
                      <div className="relative bg-[#111418] border border-[#334155] w-28 rounded-sm p-2 shadow flex flex-col h-20 justify-between mt-2" id="block-burner">
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] text-amber-500 uppercase font-mono font-bold">Heat Input</span>
                          <Flame className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                        </div>
                        <p className="text-[9px] uppercase font-medium text-slate-400">Burner Valve</p>
                        <div className="font-mono text-xs font-bold text-amber-400 text-right">
                          {reading ? `${reading.burner_pct}%` : "--"}
                        </div>
                      </div>
                    </div>

                    {/* Air Damper feeding into Drum */}
                    <div className="flex flex-col items-center relative" id="damper-connector-area">
                      <div className="absolute top-[-48px] left-[50%] h-[48px] w-[1px] border-l-2 border-dotted border-slate-800"></div>
                      <div className={`relative border w-28 rounded-sm p-2 shadow flex flex-col h-20 justify-between mt-2 transition-all ${getBlockClasses('air-damper').border}`} id="block-air-damper">
                        <div className="flex items-center justify-between">
                          <span className={`text-[8px] uppercase font-mono ${
                            reading?.status === 'FAULT' ? 'text-red-400' : reading?.status === 'WARNING' ? 'text-amber-400' : 'text-[#3b82f6]'
                          }`}>Air System</span>
                          <Wind className={`w-3.5 h-3.5 ${
                            reading?.status === 'FAULT' ? 'text-red-400 animate-bounce' : reading?.status === 'WARNING' ? 'text-amber-400 animate-spin' : 'text-slate-400'
                          }`} style={reading?.status === 'WARNING' ? { animationDuration: '0.8s' } : undefined} />
                        </div>
                        <p className={`text-[9px] uppercase font-medium ${
                          reading?.status === 'FAULT' ? 'text-red-300' : reading?.status === 'WARNING' ? 'text-amber-200' : 'text-slate-400'
                        }`}>Damper & Fan</p>
                        <div className={`font-mono text-xs font-bold text-right ${
                          reading?.status === 'FAULT' ? 'text-red-400' : reading?.status === 'WARNING' ? 'text-amber-400' : 'text-sky-400'
                        }`}>
                          {reading ? `${reading.airflow_pct}%` : "--"}
                        </div>
                      </div>
                    </div>

                    {/* Drum Motor driving Roaster */}
                    <div className="flex flex-col items-center relative" id="motor-connector-area">
                      <div className="absolute top-[-48px] left-[50%] h-[48px] w-[1px] border-l-2 border-dotted border-slate-800"></div>
                      <div className="relative bg-[#111418] border border-[#334155] w-28 rounded-sm p-2 shadow flex flex-col h-20 justify-between mt-2" id="block-motor">
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] text-slate-500 uppercase font-mono">Mechanical</span>
                          <RotateCw className="w-3.5 h-3.5 text-emerald-400 animate-spin" style={{ animationDuration: '3s' }} />
                        </div>
                        <p className="text-[9px] uppercase font-medium text-slate-400">Drum Motor</p>
                        <div className="font-mono text-xs font-bold text-[#10b981] text-right">
                          {reading ? `${reading.drum_rpm} rpm` : "--"}
                        </div>
                      </div>
                    </div>

                    {/* Discharge Output path to Cooling Tray */}
                    <div className="flex flex-col items-center relative" id="cooling-connector-area">
                      <div className="absolute top-[-48px] left-[50%] h-[48px] w-[1px] border-l-2 border-dotted border-slate-800"></div>
                      <div className="relative bg-[#111418] border border-[#334155] w-28 rounded-sm p-2 shadow flex flex-col h-20 justify-between mt-2" id="block-cooling-tray">
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] text-slate-500 uppercase font-mono">Discharge</span>
                          <Gauge className="w-3.5 h-3.5 text-slate-500" />
                        </div>
                        <p className="text-[9px] uppercase font-medium text-slate-400">Cooling Tray</p>
                        <div className="font-mono text-xs font-bold text-slate-400 text-right">
                          Ambient
                        </div>
                      </div>
                    </div>

                  </div>

                </div>

              </div>

              {/* BFD Operator Quick Info Banner */}
              <div className="mt-4 bg-[#111418] border border-[#1e293b] rounded-sm p-3 flex items-start space-x-3.5" id="flow-status-footer">
                <Info className="w-5 h-5 text-[#3b82f6] mt-0.5" id="info-icon" />
                <div className="text-xs">
                  <h4 className="font-bold text-slate-200">SCADA State Diagram Info</h4>
                  <p className="text-slate-400 font-mono text-[10px]">
                    Continuous heat-exchange BFD is currently active. Green borders represent healthy sensors, and dotted connection links represent hot air intake pipelines.
                  </p>
                </div>
              </div>

            </div>

            {/* RIGHT SIDEBAR (~30%): RECIPE PARAMETERS PANELS */}
            <div className="w-[340px] h-full bg-[#0a0c0f] border-l border-[#1e293b] flex flex-col justify-between" id="recipe-settings-sidebar">
              
              {/* Header Box */}
              <div className="p-4 border-b border-[#1e293b]" id="recipe-header">
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#3b82f6] font-bold">Input Panel</span>
                <h2 className="font-sans font-bold text-sm text-slate-100">Recipe Parameters</h2>
              </div>

              {/* Form Areas */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 shadow-inner" id="recipe-fields-list">
                
                {/* Profile Preset */}
                <div>
                  <label className="block text-[10px] uppercase font-medium text-slate-400 tracking-wider mb-1">
                    Profile Preset
                  </label>
                  <select
                    id="input-profile-preset"
                    value={recipe.profilePreset}
                    onChange={(e) => handleRecipeChange('profilePreset', e.target.value)}
                    className="w-full bg-[#111418] border border-[#334155] text-slate-200 text-xs rounded-sm p-2 outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]"
                  >
                    <option value="City">City (Light Roast)</option>
                    <option value="Full City">Full City (Medium-Dark)</option>
                    <option value="Vienna">Vienna (Dark Roast)</option>
                    <option value="Custom">Custom Override Profile</option>
                  </select>
                </div>

                {/* Batch Size */}
                <div>
                  <label className="block text-[10px] uppercase font-medium text-slate-400 tracking-wider mb-1">
                    Batch Size (kg)
                  </label>
                  <input
                    id="input-batch-size"
                    type="number"
                    value={recipe.batchSize}
                    onChange={(e) => handleRecipeChange('batchSize', parseFloat(e.target.value) || 0)}
                    className="w-full bg-[#111418] border border-[#334155] text-slate-200 text-xs font-mono rounded-sm p-2 outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]"
                  />
                </div>

                {/* Charge Temperature */}
                <div>
                  <label className="block text-[10px] uppercase font-medium text-slate-400 tracking-wider mb-1">
                    Charge Temp (°C)
                  </label>
                  <input
                    id="input-charge-temp"
                    type="number"
                    value={recipe.chargeTemp}
                    onChange={(e) => handleRecipeChange('chargeTemp', parseFloat(e.target.value) || 0)}
                    className="w-full bg-[#111418] border border-[#334155] text-slate-200 text-xs font-mono rounded-sm p-2 outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]"
                  />
                </div>

                {/* Target Drop Temp */}
                <div>
                  <label className="block text-[10px] uppercase font-medium text-slate-400 tracking-wider mb-1">
                    Target Drop Temp (°C)
                  </label>
                  <input
                    id="input-target-drop-temp"
                    type="number"
                    value={recipe.targetDropTemp}
                    onChange={(e) => handleRecipeChange('targetDropTemp', parseFloat(e.target.value) || 0)}
                    className="w-full bg-[#111418] border border-[#334155] text-slate-200 text-xs font-mono rounded-sm p-2 outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]"
                  />
                </div>

                {/* Burner Setpoint */}
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[10px] uppercase font-medium text-slate-400 tracking-wider">
                      Burner Setpoint (%)
                    </label>
                    <span className="font-mono text-[10px] text-amber-500 font-bold">{recipe.burnerSetpoint}%</span>
                  </div>
                  <input
                    id="input-burner-setpoint"
                    type="range"
                    min="0"
                    max="100"
                    value={recipe.burnerSetpoint}
                    onChange={(e) => handleRecipeChange('burnerSetpoint', parseInt(e.target.value) || 0)}
                    className="w-full h-1 bg-[#1e293b] rounded-sm appearance-none cursor-pointer accent-[#3b82f6]"
                  />
                </div>

                {/* Airflow */}
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[10px] uppercase font-medium text-slate-400 tracking-wider">
                      Airflow (%)
                    </label>
                    <span className="font-mono text-[10px] text-sky-400 font-bold">{recipe.airflow}%</span>
                  </div>
                  <input
                    id="input-airflow"
                    type="range"
                    min="0"
                    max="100"
                    value={recipe.airflow}
                    onChange={(e) => handleRecipeChange('airflow', parseInt(e.target.value) || 0)}
                    className="w-full h-1 bg-[#1e293b] rounded-sm appearance-none cursor-pointer accent-[#3b82f6]"
                  />
                </div>

                {/* Drum Speed */}
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[10px] uppercase font-medium text-slate-400 tracking-wider">
                      Drum Speed (rpm)
                    </label>
                    <span className="font-mono text-[10px] text-emerald-400 font-bold">{recipe.drumSpeed} rpm</span>
                  </div>
                  <input
                    id="input-drum-speed"
                    type="range"
                    min="0"
                    max="100"
                    value={recipe.drumSpeed}
                    onChange={(e) => handleRecipeChange('drumSpeed', parseInt(e.target.value) || 0)}
                    className="w-full h-1 bg-[#1e293b] rounded-sm appearance-none cursor-pointer accent-[#3b82f6]"
                  />
                </div>

                {/* Total Roast Time */}
                <div>
                  <label className="block text-[10px] uppercase font-medium text-slate-400 tracking-wider mb-1">
                    Total Roast Time (mm:ss)
                  </label>
                  <input
                    id="input-roast-time"
                    type="text"
                    value={recipe.totalRoastTime}
                    onChange={(e) => handleRecipeChange('totalRoastTime', e.target.value)}
                    className="w-full bg-[#111418] border border-[#334155] text-slate-200 text-xs font-mono rounded-sm p-2 outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]"
                    placeholder="11:30"
                  />
                </div>

                {/* Target ROR */}
                <div>
                  <label className="block text-[10px] uppercase font-medium text-slate-400 tracking-wider mb-1">
                    Target ROR (°C/min)
                  </label>
                  <input
                    id="input-target-ror"
                    type="number"
                    value={recipe.targetRor}
                    onChange={(e) => handleRecipeChange('targetRor', parseFloat(e.target.value) || 0)}
                    className="w-full bg-[#111418] border border-[#334155] text-slate-200 text-xs font-mono rounded-sm p-2 outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]"
                  />
                </div>

              </div>

              {/* ACTION TOGGLE: RUN ROAST AREA */}
              <div className="p-4 border-t border-[#1e293b] bg-[#0a0c0f] flex flex-col space-y-3" id="run-control-box">
                {isRoastRunning && (
                  <div className="flex items-center space-x-2 bg-red-950/40 text-red-500 border border-red-900/40 p-2 rounded-sm justify-center text-[10px] font-mono tracking-wider font-bold animate-pulse">
                    <span>LIVE MISSION CRITICAL ACTION IN PROGRESS</span>
                  </div>
                )}
                
                <button
                  id="btn-run-roast"
                  onClick={handleToggleRoast}
                  className={`w-full py-3.5 flex items-center justify-center space-x-2.5 rounded-sm text-xs uppercase tracking-widest font-bold transition-all cursor-pointer ${
                    isRoastRunning 
                      ? 'bg-[#ef4444] hover:bg-[#dc2626] text-white' 
                      : 'bg-[#3b82f6] hover:bg-[#2563eb] text-white'
                  }`}
                >
                  {isRoastRunning ? (
                    <>
                      <Square className="w-4 h-4 fill-white text-white" />
                      <span>Stop Roast</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-white text-white" />
                      <span>Run Roast</span>
                    </>
                  )}
                </button>
              </div>

            </div>

          </div>
        ) : (
          
          /* TAB 2: FOREMAN AI SYSTEM */
          <div className="flex h-full w-full overflow-hidden" id="foreman-view-grid">
            
            {/* LARGE UPPER ROW WITH LIVE NUMERIC TILES AND 2x2 CHART GRID */}
            <div className="flex-1 h-full flex flex-col overflow-y-auto bg-[#0a0c0f]" id="scada-telemetry-panel">
              
              {/* TOP HEADER SECTION OF TELEMETRY TAB */}
              <div className="p-4 border-b border-[#1e293b] bg-[#0d1014] flex items-center justify-between" id="telemetry-topbar">
                <div className="flex items-center space-x-3">
                  <span className="text-[10px] font-mono text-[#3b82f6] bg-[rgba(59,130,246,0.1)] border border-[#3b82f6]/30 px-2 py-0.5 rounded-sm uppercase font-bold tracking-widest animate-pulse">
                    AI Active
                  </span>
                  <h3 className="text-xs uppercase tracking-wider font-bold text-slate-200">
                    Continuous Roast Stream Monitoring Overview
                  </h3>
                </div>

                {/* Normal/Critical Pill Indicator */}
                <div className={`flex items-center space-x-2 px-3.5 py-1 border rounded-sm text-[10px] font-mono font-bold tracking-widest uppercase ${getStatusBadgeStyle(reading?.status).text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${getStatusBadgeStyle(reading?.status).dot}`}></span>
                  <span>{getStatusBadgeStyle(reading?.status).label}</span>
                </div>
              </div>

              {/* TELEMETRY READOUTS (ROW OF 8 MINI TILES) */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-1.5 p-3.5 bg-[#0a0c0f] border-b border-[#1e293b]" id="scada-tiles-row">
                
                {/* 1. Bean Temp */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-bean-temp">
                  <span className="text-[9px] uppercase hover:text-slate-200 text-slate-500 transition-colors leading-none tracking-wider">bean_temp_c</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-[#3b82f6] tracking-tight">
                      {reading ? reading.bean_temp_c.toFixed(1) : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">°C</span>
                  </div>
                </div>

                {/* 2. Drum Temp */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-drum-temp">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">drum_temp_c</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-[#ef4444] tracking-tight">
                      {reading ? reading.drum_temp_c.toFixed(1) : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">°C</span>
                  </div>
                </div>

                {/* 3. Airflow Pct */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-airflow">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">airflow_pct</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-[#10b981] tracking-tight">
                      {reading ? reading.airflow_pct : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">%</span>
                  </div>
                </div>

                {/* 4. Burner Pct */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-burner">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">burner_pct</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-[#f59e0b] tracking-tight">
                      {reading ? reading.burner_pct : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">%</span>
                  </div>
                </div>

                {/* 5. Drum RPM */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-drum-speed">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">drum_rpm</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-[#10b981] tracking-tight">
                      {reading ? reading.drum_rpm : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">rpm</span>
                  </div>
                </div>

                {/* 6. ROR Speed */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-ror">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">ror_c_per_min</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-amber-500 tracking-tight">
                      {reading ? reading.ror_c_per_min.toFixed(1) : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">°C/m</span>
                  </div>
                </div>

                {/* 7. Phase Stage */}
                <div className="bg-[#111418] border border-[#1e293b] p-1.5 rounded-sm flex flex-col justify-between" id="tile-phase">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">roast_phase</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-xs font-bold text-slate-200 tracking-wide truncate">
                      {reading ? reading.roast_phase.toUpperCase() : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-0.5">Stg</span>
                  </div>
                </div>

                {/* 8. Raw s */}
                <div className="bg-[#111418] border border-[#1e293b] p-2.5 rounded-sm flex flex-col justify-between" id="tile-elapsed">
                  <span className="text-[9px] uppercase text-slate-500 leading-none tracking-wider">elapsed_s</span>
                  <div className="mt-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-base font-extrabold text-slate-300 tracking-tight">
                      {reading ? reading.elapsed_s : "--"}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500 ml-1">s</span>
                  </div>
                </div>

              </div>

              {/* 2x2 RECHARTS GRID */}
              <div className="flex-1 p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 pb-12" id="scada-charts-2x2">
                
                {/* CHART 1: BEAN TEMP */}
                <div className={`bg-[#111418] border rounded-sm p-4 flex flex-col justify-between transition-all duration-300 ${cardGlow('bean_temp_c')}`} id="ch-card-bean-temp">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Thermometer className="w-4 h-4 text-[#3b82f6]" />
                      <span className="text-xs font-bold uppercase text-slate-300">bean_temp_c (Bean probe profile)</span>
                    </div>
                    <span className="font-mono text-xs font-bold text-[#3b82f6]">
                      {reading ? `${reading.bean_temp_c.toFixed(1)} °C` : "--"}
                    </span>
                  </div>
                  <div className="h-44 w-full" id="ch-rendered-bean-temp">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={history} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="elapsed_s" stroke="#475569" fontSize={9} tickFormatter={formatElapsed} />
                        <YAxis stroke="#475569" fontSize={9} domain={[100, 240]} />
                        <Tooltip contentStyle={{ backgroundColor: '#111418', borderColor: '#334155', fontSize: '11px', color: '#fff' }} />
                        {bandsFor('bean_temp_c')}
                        <Line type="monotone" dataKey="bean_temp_c" stroke="#3b82f6" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* CHART 2: DRUM TEMP */}
                <div className={`bg-[#111418] border rounded-sm p-4 flex flex-col justify-between transition-all duration-300 ${cardGlow('drum_temp_c')}`} id="ch-card-drum-temp">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Gauge className="w-4 h-4 text-[#ef4444]" />
                      <span className="text-xs font-bold uppercase text-slate-300">drum_temp_c (Internal environmental)</span>
                    </div>
                    <span className="font-mono text-xs font-bold text-[#ef4444]">
                      {reading ? `${reading.drum_temp_c.toFixed(1)} °C` : "--"}
                    </span>
                  </div>
                  <div className="h-44 w-full" id="ch-rendered-drum-temp">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={history} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="elapsed_s" stroke="#475569" fontSize={9} tickFormatter={formatElapsed} />
                        <YAxis stroke="#475569" fontSize={9} domain={[120, 280]} />
                        <Tooltip contentStyle={{ backgroundColor: '#111418', borderColor: '#334155', fontSize: '11px', color: '#fff' }} />
                        {bandsFor('drum_temp_c')}
                        <Line type="monotone" dataKey="drum_temp_c" stroke="#ef4444" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* CHART 3: AIRFLOW */}
                <div className={`bg-[#111418] border rounded-sm p-4 flex flex-col justify-between transition-all duration-300 ${cardGlow('airflow_pct')}`} id="ch-card-airflow">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Wind className="w-4 h-4 text-[#10b981]" />
                      <span className="text-xs font-bold uppercase text-slate-300">airflow_pct (By-pass damper exhaust)</span>
                    </div>
                    <span className="font-mono text-xs font-bold text-[#10b981]">
                      {reading ? `${reading.airflow_pct.toFixed(1)} %` : "-- %"}
                    </span>
                  </div>
                  <div className="h-44 w-full" id="ch-rendered-airflow">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={history} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="elapsed_s" stroke="#475569" fontSize={9} tickFormatter={formatElapsed} />
                        <YAxis stroke="#475569" fontSize={9} domain={[0, 100]} />
                        <Tooltip contentStyle={{ backgroundColor: '#111418', borderColor: '#334155', fontSize: '11px', color: '#fff' }} />
                        {bandsFor('airflow_pct')}
                        <Line type="monotone" dataKey="airflow_pct" stroke="#10b981" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* CHART 4: ROR (RATE OF RISE) */}
                <div className={`bg-[#111418] border rounded-sm p-4 flex flex-col justify-between transition-all duration-300 ${cardGlow('ror_c_per_min')}`} id="ch-card-ror">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <TrendingUp className="w-4 h-4 text-[#f59e0b]" />
                      <span className="text-xs font-bold uppercase text-slate-300">ror_c_per_min (Roast kinetics Index)</span>
                    </div>
                    <span className="font-mono text-xs font-bold text-[#f59e0b]">
                      {reading ? `${reading.ror_c_per_min.toFixed(1)} °C/min` : "-- °C/min"}
                    </span>
                  </div>
                  <div className="h-44 w-full" id="ch-rendered-ror">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={history} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="elapsed_s" stroke="#475569" fontSize={9} tickFormatter={formatElapsed} />
                        <YAxis stroke="#475569" fontSize={9} domain={[-30, 35]} />
                        <Tooltip contentStyle={{ backgroundColor: '#111418', borderColor: '#334155', fontSize: '11px', color: '#fff' }} />
                        {bandsFor('ror_c_per_min')}
                        <Line type="monotone" dataKey="ror_c_per_min" stroke="#f59e0b" strokeWidth={2.5} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

              </div>

              {/* AUDIT LOG — human approval decisions */}
              <div className="px-4 pb-6" id="foreman-audit-log">
                <div className="bg-[#111418] border border-[#1e293b] rounded-sm">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e293b]">
                    <div className="flex items-center space-x-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-[10px] uppercase font-bold tracking-widest text-slate-300">Approval Audit Log</span>
                    </div>
                    <span className="font-mono text-[9px] text-slate-500">{auditLog.length} {auditLog.length === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  {auditLog.length === 0 ? (
                    <p className="px-3 py-3 text-[10px] font-mono text-slate-600">
                      No decisions yet. Approvals and rejections will be recorded here.
                    </p>
                  ) : (
                    <div className="divide-y divide-[#1e293b]">
                      {auditLog.map((entry) => (
                        <div key={entry.id} className="px-3 py-2 flex items-start space-x-3" id={`audit-${entry.id}`}>
                          <span className="font-mono text-[9px] text-slate-500 mt-0.5 shrink-0">{entry.timestamp}</span>
                          <span className="font-mono text-[9px] text-slate-400 mt-0.5 shrink-0">{entry.operator}</span>
                          <span className={`font-mono text-[8px] uppercase font-bold px-1.5 py-0.5 rounded-sm border shrink-0 ${
                            entry.decision === 'APPROVED'
                              ? 'text-emerald-400 border-emerald-500/40 bg-emerald-950/30'
                              : 'text-red-400 border-red-500/40 bg-red-950/30'
                          }`}>{entry.decision}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] text-slate-300 leading-snug">{entry.approval_summary}</p>
                            <p className="text-[9px] text-slate-500 mt-0.5">→ {entry.outcome}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT SIDEBAR PINNED CHAT CO-WORKER FOR FOREMAN AI DIAGNOSTICS */}
            <div className="w-[360px] h-full bg-[#0a0c0f] border-l border-[#1e293b] flex flex-col justify-between" id="foreman-ai-chatbar">
              
              {/* Box Title */}
              <div className="p-4 border-b border-[#1e293b] bg-[#0d1014] flex items-center justify-between" id="chat-header">
                <div className="flex items-center space-x-2">
                  <MessageSquare className="w-4 h-4 text-[#3b82f6]" />
                  <span className="font-sans font-bold text-sm text-slate-100">Foreman Assistant Link</span>
                </div>
                <div className="flex items-center space-x-1.5 flex-row">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping"></span>
                  <span className="text-[9px] font-mono border border-blue-900/30 p-1 rounded-sm bg-[#111418] text-[#3b82f6] font-semibold tracking-wider">
                    OPERATOR SECURE
                  </span>
                </div>
              </div>

              {/* Scrollable Conversation Workspace Thread */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4" id="chat-conversation-container">
                {messages.map((msg) => {
                  const isRich = msg.kind === 'fault_tree' || msg.kind === 'plan';
                  return (
                    <div
                      key={msg.id}
                      id={`msg-${msg.id}`}
                      className={`flex flex-col whitespace-pre-wrap leading-relaxed ${
                        isRich ? 'max-w-full w-full' : 'max-w-[90%]'
                      } ${msg.sender === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'}`}
                    >
                      {/* Username detail metadata */}
                      <div className="flex items-center space-x-2 mb-1">
                        <span className="text-[9px] uppercase font-bold tracking-widest text-slate-500">
                          {msg.sender === 'user' ? 'Operator' : 'Foreman AI'}
                        </span>
                        <span className="text-[8px] font-mono text-slate-600">{msg.timestamp}</span>
                      </div>

                      {/* Speech box wrapper */}
                      <div
                        className={`text-xs p-3 rounded-sm w-full ${
                          msg.sender === 'user'
                            ? 'bg-[#1e293b] text-slate-100 border border-[#334155]/50 rounded-tr-none'
                            : msg.kind === 'error'
                            ? 'bg-red-950/30 text-red-200 border border-red-900/50 rounded-tl-none'
                            : msg.kind === 'confirmation'
                            ? 'bg-emerald-950/20 text-emerald-100 border border-emerald-800/40 rounded-tl-none'
                            : msg.kind === 'intro'
                            ? 'bg-[#0d1014] text-slate-100 border border-[#3b82f6]/30 rounded-tl-none'
                            : 'bg-[#111418] text-slate-100 border border-[#1e293b] rounded-tl-none'
                        }`}
                      >
                        {msg.kind === 'analyzing' ? (
                          <span className="flex items-center space-x-2 text-slate-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] animate-bounce" style={{ animationDelay: '0ms' }}></span>
                            <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] animate-bounce" style={{ animationDelay: '150ms' }}></span>
                            <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] animate-bounce" style={{ animationDelay: '300ms' }}></span>
                            <span className="text-[11px] uppercase tracking-wider">Foreman is analyzing…</span>
                          </span>
                        ) : msg.kind === 'step' && msg.step ? (
                          renderStepBody(msg.step)
                        ) : msg.kind === 'fault_tree' && msg.diagnosis ? (
                          renderFaultTreeBody(msg.diagnosis)
                        ) : msg.kind === 'plan' && msg.plan ? (
                          renderPlanBody(msg)
                        ) : (
                          msg.text
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Bottom control blocks: Suggested chips, Input Box + Action trigger button */}
              <div className="p-4 border-t border-[#1e293b] bg-[#0a0c0f]" id="chat-input-controls-area">
                
                {/* 2-3 suggested-question chips that fill the inputs */}
                <div className="flex flex-wrap gap-1.5 mb-3" id="suggested-chips">
                  {SUGGESTED_QUESTIONS.map((chip, idx) => (
                    <button
                      key={idx}
                      id={`suggested-chip-${idx}`}
                      disabled={isAnalyzing}
                      onClick={() => handleSendMessage(chip)}
                      className={`text-[10px] font-mono bg-[#111418] hover:bg-[#1e293b] text-slate-400 hover:text-slate-100 border border-[#1e293b] px-2 py-1.5 rounded-sm transition-all text-left truncate max-w-full ${
                        isAnalyzing ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                      }`}
                    >
                      <span className="text-[#3b82f6] mr-1">#</span> {chip}
                    </button>
                  ))}
                </div>

                {/* Send action element */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMessage();
                  }}
                  className="flex items-center bg-[#111418] border border-[#334155] rounded-sm p-1 focus-within:border-[#3b82f6] transition-colors"
                  id="chat-send-form"
                >
                  <input
                    id="chat-text-input"
                    type="text"
                    value={chatInput}
                    disabled={isAnalyzing}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={isAnalyzing ? 'Foreman is analyzing…' : 'Ask Foreman about the roast…'}
                    className="flex-1 bg-transparent text-xs text-slate-200 outline-none px-2.5 h-9 disabled:opacity-50"
                  />
                  <button
                    id="chat-btn-send"
                    type="submit"
                    disabled={isAnalyzing}
                    className={`p-2 bg-[#3b82f6] hover:bg-[#2563eb] text-white rounded-sm transition-all shrink-0 ${
                      isAnalyzing ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    <Send className="w-3.5 h-3.5 fill-white stroke-white" />
                  </button>
                </form>

              </div>

            </div>

          </div>

        )}
      </main>

    </div>
  );
}
