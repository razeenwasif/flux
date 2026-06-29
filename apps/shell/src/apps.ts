/**
 * Pinned Flux apps (the user's own web apps) — shared registry used by the app
 * dock (bottom-right launcher), the floating app panes, and Gemma. Each app ships
 * a concise guide so Gemma can assist while the app is open (injected into her
 * chat context by AgentPanel when an app pane is active).
 */
export type FluxApp = {
  id: string;
  name: string;
  /** Deployed URL opened in the floating pane. */
  url: string;
  /** Hostname (favicon source + matching). */
  host: string;
  /** One-line description (dock tooltip + Gemma's app list). */
  tagline: string;
  /** Accent colour for the monogram fallback. */
  tint: string;
  /** Bundled icon (served from /public), preferred over the remote favicon. */
  iconAsset?: string;
  /** Full usage guide (Markdown) — given to Gemma when this app is in use. */
  guide: string;
};

export const FLUX_APPS: FluxApp[] = [
  {
    id: "nexus",
    name: "Nexus",
    url: "https://nexus-cluster.web.app",
    host: "nexus-cluster.web.app",
    tagline: "Real-time ML training console for your cluster",
    tint: "#7b61ff",
    iconAsset: "/app-nexus.svg",
    guide: `# Nexus — Real-time ML training console for distributed clusters
**What it is:** A web control plane + monitoring dashboard for personal ML training clusters. Register machines as "devices," spawn training pods on demand, submit runs, and watch metrics stream live — replacing manual SSH + tmux with one-click device management and visual analytics. Firebase + Python daemons.
**Key features / workflows:**
- Fleet tab: install \`device_agent\` on a machine → it appears → Connect spawns \`pod_agent\`; Disconnect stops it.
- Mission tab: ⌘K → "Start a Training Run…" → set hyperparameters/dataset/pod target → live loss/accuracy curves; cancel/delete runs.
- Sweeps: grid / random / Bayesian (scikit-optimize) over an HP space; coordinator auto-spawns child runs with live top-K ranking.
- Datasets: fetch from URL, Hugging Face Hub, or drag-drop upload (Firebase Storage); passed as \`--dataset\`.
- Console tab: full xterm.js shell on any device over a Firebase RTDB relay (<100 ms).
- Compare: overlay 2–6 runs' curves + a spec-diff table (lr, seed, git hash, dataset…).
- Auto-recovery: failed runs retry up to 3× from \`checkpoints/last.pt\`; OOM scales batch size ×0.75.
**How Gemma can help:**
- Explain the Fleet / Mission / Analytics / Console tabs and the Connect workflow.
- Walk through device install (\`scripts/install-device-agent.sh --owner-uid <UID>\`).
- Help draft a run request or sweep spec for a training goal; suggest HP ranges.
- Diagnose failure reasons (OOM, error) and suggest fixes.
- Explain how to compare runs or read a sweep's top-K.
**Glossary:** Device (a registered machine) · Pod (a spawned \`pod_agent\`) · Run (one job + telemetry) · Sweep (a batch over an HP grid) · Spec (the submitted run config) · RTDB (Firebase Realtime DB, low-latency I/O).`,
  },
  {
    id: "prism",
    name: "Prism",
    url: "https://prism-automl.web.app",
    host: "prism-automl.web.app",
    tagline: "GPU-powered AutoML & entity resolution",
    tint: "#2ff3ff",
    iconAsset: "/app-prism.svg",
    guide: `# Prism — GPU-powered AutoML & entity resolution platform
**What it is:** A GPU-aware AutoML suite for end-to-end data science — dataset upload → profiling → cleaning → feature engineering → model selection → hyperparameter search → evaluation — plus a record-linkage engine for matching/merging duplicate records via semantic similarity + supervised classification. React dashboard + REST API.
**Key features / workflows:**
- Upload CSV/Parquet/JSON; auto-detect task (regression / classification / clustering).
- Auto data profiling: missing values, distributions, correlations, duplicates, outliers.
- Cleaning: drop high-missing columns, dedupe, impute, clip outliers. Feature engineering: scaling, one-hot/frequency encoding, text features.
- GPU Optuna HPO across a model zoo (XGBoost, LightGBM, neural nets, K-Means, GMM…).
- Task-aware viz: confusion matrices, residuals, ROC, embeddings.
- Record linkage: multi-pass blocking + semantic embeddings + active learning to confirm uncertain pairs.
- AI data actions: LLM text cleaning, zero-shot classification, topic discovery (UMAP + HDBSCAN). Local Mode runs heavy compute on your own GPU.
**How Gemma can help:**
- Interpret metrics (accuracy, F1, ROC-AUC, RMSE), confusion matrices, residual plots.
- Suggest next steps: retrain with different HP, drop leaky features, try ensembles, gather more data.
- Explain pipeline stages (why dedupe/impute/scale matter; what Optuna does).
- Flag data issues (class imbalance, outliers) and fixes.
- Explain record-linkage blocking, similarity metrics, and match-confidence scores.
**Glossary:** HPO (Optuna Bayesian HP search) · Blocking (pre-filter candidate pairs) · Semantic similarity (embedding match) · Task (regression/classification/clustering) · Active learning (human confirms uncertain pairs).`,
  },
  {
    id: "vector",
    name: "Vector",
    url: "https://vector-amaterasu.web.app",
    host: "vector-amaterasu.web.app",
    tagline: "Keyboard-first project & issue tracker",
    tint: "#ec4be0",
    guide: `# Vector — Keyboard-first project & issue tracker
**What it is:** A fast, server-backed issue tracker (SQLite + auth, multi-user) built for keyboard power-users. Issues live in projects, carry status/priority/assignee, and keep an activity log; status can auto-sync from git branches/commits.
**Key features / workflows:**
- Create/edit issues (title, description, status, priority); assign to people; filter by project/status/priority/assignee.
- Search by title or ID (\`/\` focuses search); "Assigned to me" / "My Active" views.
- Full keyboard nav: \`j\`/\`k\` move, \`Enter\`/\`o\` open, \`c\`/\`n\` new, \`Esc\` close, \`?\` shortcut help.
- Activity log per issue; Git Sync auto-advances status from branch names (\`feature/VEC-1\`→IN_PROGRESS) and commits (\`fix VEC-1\`→DONE).
- JSON backups + SQLite snapshots for recovery. Demo login: \`alice@vector.local\` / \`vector-demo\`.
**How Gemma can help:**
- Teach the keyboard shortcuts to create/navigate/edit issues faster.
- Help filter/search by project, status, priority, assignee.
- Explain the status workflow (BACKLOG → TODO → IN_PROGRESS → DONE/CANCELED) and help organise work.
- Explain Git Sync (link branches/commits to auto-move status).
- Walk through backup/restore.
**Glossary:** Issue · Project (container, e.g. VEC) · Status (BACKLOG/TODO/IN_PROGRESS/DONE/CANCELED) · Priority (URGENT…NO_PRIORITY) · Assignee · Activity (logged change) · Git Sync.`,
  },
  {
    id: "oracle",
    name: "Oracle",
    url: "https://oracle-neuro-sym.web.app",
    host: "oracle-neuro-sym.web.app",
    tagline: "AI plant identification (neuro-symbolic)",
    tint: "#7cf5b0",
    guide: `# Oracle — AI-powered plant identification platform
**What it is:** A web app that identifies plant species from photos with a deep-learning backend, returning confidence-ranked species with Grad-CAM heatmaps and GBIF/Wikipedia citations, and saving discoveries to a personal herbarium. Free tier (5 IDs/day), pro subscription, developer API, and agentic ecological reports.
**Key features / workflows:**
- Identify: drag-drop a photo → top-5 species with confidence %, expandable Grad-CAM heatmaps, citations; save to library.
- Library (Journal): saved IDs with streaks, rarity scoring, exportable PDF field reports.
- Atlas: 3D globe + 2D map of real-time ID pins (color-coded by domain), density heatmaps, time filters.
- Discover: live feed of recent IDs. Trust: benchmarks, data lineage, AC-3 neuro-symbolic reasoning viz.
- Reports: ecological health summaries via a Gemma LLM backend. Devs: API keys + \`POST /identify\`.
- Auth/tiers: free / pro (unlimited + rare-species alerts) / field (offline) / admin; Firebase Auth + Google OAuth.
**How Gemma can help:**
- Explain what a Grad-CAM heatmap shows and why it builds trust.
- Compare tiers (free vs pro) and guide signup.
- Clarify top-1 confidence vs top-5 candidates.
- Walk through exporting a PDF field report.
- Explain how the AC-3 neuro-symbolic layer prunes candidates by taxonomy/biogeography.
- Help developers authenticate + call \`/identify\`.
**Glossary:** Identify (upload→inference→results) · Journal/Library (saved IDs) · Heatmap (Grad-CAM attention) · AC-3 (constraint-pruning by habitat/geography/phenology) · Pro tier · API key.`,
  },
];

export const appByHost = (host: string): FluxApp | undefined =>
  FLUX_APPS.find((a) => host === a.host || host.endsWith(`.${a.host}`));
