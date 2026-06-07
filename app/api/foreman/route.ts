import { GoogleGenAI, Type } from '@google/genai';

// Server-side route. Holds GEMINI_API_KEY (never shipped to the browser) and
// fronts two Gemini calls behind a single endpoint switched on `stage`:
//   - "diagnose": narrated fault-tree diagnosis of a flagged anomaly
//   - "plan":     smallest conservative, human-gated corrective plan
// Both use gemini-2.5-flash with responseMimeType application/json + a schema.

export const runtime = 'nodejs';

const MODEL = 'gemini-2.5-flash';

const EQUIPMENT_CONFIG = `EQUIPMENT: Drum coffee roaster (batch), 12 kg.
SENSORS: bean_temp_c, drum_temp_c, exhaust_temp_c, airflow_pct, burner_pct, drum_rpm, ror_c_per_min, roast_phase, elapsed_s.
NORMAL: ror 8-15 early tapering to 3-6 in development (never rises late); airflow 40-70 stable; burner 50-80 stepping down; drum_rpm 55-65; exhaust ~10-25C above bean_temp.
FAILURE MODES:
- SCORCHING/TIPPING: drum_temp rises fast, airflow drops, ror spikes -> burner stuck high / gas valve fault; airflow damper blocked or fan failing; too-aggressive profile.
- BAKING/STALL: ror collapses toward 0, bean_temp plateaus -> burner under-firing; damper stuck open; thermocouple high.
- UNEVEN ROAST: erratic airflow / unstable drum_rpm -> drum motor slipping; damper hunting.
- INSTRUMENT FAULT (always consider): mutually inconsistent readings -> thermocouple drift / wiring.`;

const DIAGNOSE_SYSTEM =
  'You are Foreman, a process-engineering analyst for a coffee roasting line. Given a flagged anomaly and a telemetry window, produce an interactive DIAGNOSIS that walks a human operator through the evidence step by step, like a senior engineer narrating a chart review. DIAGNOSIS ONLY — you do not act. Build a fault tree (top event -> intermediate causes -> root causes). Ground every claim in the supplied telemetry; never invent sensors. Produce ordered analysis_steps; each focuses on ONE signal, states what it shows, and gives the exact elapsed-second range that proves the point so the UI can highlight it on the chart. Confidence 0.0-1.0. Always include an instrument-fault branch when readings are inconsistent. Return ONLY JSON matching the schema.';

const PLAN_SYSTEM =
  "You are Foreman's remediation planner. Given the completed diagnosis, produce the SMALLEST conservative corrective plan. A human MUST approve before anything executes; set requires_human_approval true always. Automatable setpoint changes first; physical steps tagged 'manual'. Each step: target parameter, current value, proposed value, expected effect, risk + one-line note. Provide rollback_plan. Write approval_summary as ONE plain sentence. Return ONLY JSON.";

const diagnoseSchema = {
  type: Type.OBJECT,
  properties: {
    intro: { type: Type.STRING },
    analysis_steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          step_number: { type: Type.INTEGER },
          signal: {
            type: Type.STRING,
            enum: ['bean_temp_c', 'drum_temp_c', 'airflow_pct', 'ror_c_per_min'],
          },
          narration: { type: Type.STRING },
          highlight_from_s: { type: Type.NUMBER },
          highlight_to_s: { type: Type.NUMBER },
          finding: { type: Type.STRING },
        },
        required: [
          'step_number',
          'signal',
          'narration',
          'highlight_from_s',
          'highlight_to_s',
          'finding',
        ],
      },
    },
    fault_tree: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          intermediate_cause: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          root_causes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                cause: { type: Type.STRING },
                confidence: { type: Type.NUMBER },
                evidence: { type: Type.STRING },
                verification_step: { type: Type.STRING },
              },
              required: ['cause', 'confidence', 'evidence', 'verification_step'],
            },
          },
        },
        required: ['intermediate_cause', 'confidence', 'root_causes'],
      },
    },
    most_likely_root_cause: { type: Type.STRING },
    severity: { type: Type.STRING, enum: ['low', 'medium', 'high', 'critical'] },
    summary: { type: Type.STRING },
  },
  required: [
    'intro',
    'analysis_steps',
    'fault_tree',
    'most_likely_root_cause',
    'severity',
    'summary',
  ],
};

const planSchema = {
  type: Type.OBJECT,
  properties: {
    objective: { type: Type.STRING },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          step_number: { type: Type.INTEGER },
          action: { type: Type.STRING },
          type: { type: Type.STRING, enum: ['automatable', 'manual'] },
          target_parameter: { type: Type.STRING },
          current_value: { type: Type.STRING },
          proposed_value: { type: Type.STRING },
          expected_effect: { type: Type.STRING },
          risk: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
          risk_note: { type: Type.STRING },
        },
        required: [
          'step_number',
          'action',
          'type',
          'target_parameter',
          'current_value',
          'proposed_value',
          'expected_effect',
          'risk',
          'risk_note',
        ],
      },
    },
    requires_human_approval: { type: Type.BOOLEAN },
    approval_summary: { type: Type.STRING },
    rollback_plan: { type: Type.STRING },
  },
  required: [
    'objective',
    'steps',
    'requires_human_approval',
    'approval_summary',
    'rollback_plan',
  ],
};

// Gemini sometimes wraps JSON in ```json fences despite responseMimeType; strip them.
function stripFences(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return t.trim();
}

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'GEMINI_API_KEY is not set. Add it to .env.local and restart the dev server.' },
      { status: 500 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const stage = body.stage;
  const ai = new GoogleGenAI({ apiKey });

  let systemInstruction: string;
  let temperature: number;
  let responseSchema: unknown;
  let userMessage: string;

  if (stage === 'diagnose') {
    systemInstruction = DIAGNOSE_SYSTEM;
    temperature = 0.2;
    responseSchema = diagnoseSchema;
    userMessage =
      `${EQUIPMENT_CONFIG}\n\n` +
      `FLAGGED ANOMALY:\n${String(body.anomaly ?? 'Operator requested a review of the current roast.')}\n\n` +
      `TELEMETRY WINDOW (most recent readings, JSON):\n${JSON.stringify(body.telemetry ?? [], null, 2)}`;
  } else if (stage === 'plan') {
    systemInstruction = PLAN_SYSTEM;
    temperature = 0.3;
    responseSchema = planSchema;
    const rejection = body.rejection_reason
      ? `\n\nThe operator REJECTED the previous plan with this reason: "${String(
          body.rejection_reason,
        )}". Produce a revised, even more conservative plan that addresses it.`
      : '';
    userMessage =
      `${EQUIPMENT_CONFIG}\n\n` +
      `COMPLETED DIAGNOSIS (JSON):\n${JSON.stringify(body.diagnosis ?? {}, null, 2)}\n\n` +
      `CURRENT SETPOINTS (JSON):\n${JSON.stringify(body.setpoints ?? {}, null, 2)}` +
      rejection;
  } else {
    return Response.json({ error: 'Unknown stage. Use "diagnose" or "plan".' }, { status: 400 });
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userMessage,
      config: {
        systemInstruction,
        temperature,
        responseMimeType: 'application/json',
        responseSchema: responseSchema as object,
        // Disable extended "thinking" — for this structured, schema-constrained
        // task it adds 20-30s of latency with little quality gain, and the live
        // demo needs the diagnosis back before the roast clock runs out.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const raw = response.text;
    if (!raw) {
      return Response.json({ error: 'Foreman returned an empty response.' }, { status: 502 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      return Response.json(
        { error: 'Foreman returned malformed JSON.', raw },
        { status: 502 },
      );
    }

    return Response.json({ data: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Gemini error.';
    return Response.json({ error: `Gemini call failed: ${message}` }, { status: 502 });
  }
}
