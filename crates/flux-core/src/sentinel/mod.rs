//! Sentinel — the AI-assisted security layer (ADR 0013).
//!
//! This first module is Pillar 0's **action audit log**: an append-only,
//! **sealed (AES-256-GCM, reusing the trace key ladder)** record of what the
//! agent did on the user's behalf — a security control *and* a trust/debug
//! surface. Detectors + the phishing verdict cache (Pillars 1–3) land beside it
//! later, hence the module dir.

mod audit;

pub use audit::{AuditEntry, SentinelAudit};
