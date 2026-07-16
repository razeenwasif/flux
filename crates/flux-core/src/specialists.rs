//! Domain-specialist routing (#120) — make a fine-tuned council-specialists model
//! a "voice" the agent routes in-domain questions to.
//!
//! The council-specialists pipeline exports models named `<domain>-specialist:<tag>`
//! (e.g. `physics-specialist:7b-council`). We **auto-discover** them from Ollama —
//! no config — and route a question to one when it carries enough of that domain's
//! vocabulary. Routing is conservative and always surfaced (a voice badge), so the
//! default Gemma still answers everything else.

use serde::Serialize;

/// A discovered specialist available to route to.
#[derive(Serialize, Clone, specta::Type)]
pub struct Specialist {
    /// e.g. "physics".
    pub domain: String,
    /// Display label, e.g. "Physics".
    pub label: String,
    /// The Ollama model tag, e.g. "physics-specialist:7b-council".
    pub model: String,
}

/// Domains the council-specialists pipeline targets, with the vocabulary that
/// signals a question belongs to each. Lowercase; matched as substrings.
const DOMAINS: &[(&str, &str, &[&str])] = &[
    (
        "physics",
        "Physics",
        &[
            "physics",
            "quantum",
            "relativity",
            "gravity",
            "gravitational",
            "spacetime",
            "particle",
            "thermodynamic",
            "entropy",
            "photon",
            "electron",
            "boson",
            "fermion",
            "hamiltonian",
            "wavefunction",
            "lagrangian",
            "gauge",
            "renormali",
            "scattering",
            "lattice",
            "qubit",
            "decoherence",
            "superconduct",
            "cosmolog",
            "string theory",
            "field theory",
            "symmetry",
        ],
    ),
    (
        "math",
        "Math",
        &[
            "theorem",
            "proof",
            "lemma",
            "conjecture",
            "topology",
            "manifold",
            "homolog",
            "algebra",
            "eigen",
            "matrix",
            "tensor",
            "integral",
            "derivative",
            "calculus",
            "polynomial",
            "isomorph",
            "group theory",
            "category theory",
            "measure theory",
            "differential equation",
        ],
    ),
    (
        "cs",
        "CS",
        &[
            "algorithm",
            "complexity",
            "np-hard",
            "np-complete",
            "compiler",
            "data structure",
            "concurrency",
            "scheduler",
            "throughput",
            "cache",
            "amortized",
            "big-o",
            "turing",
            "automat",
            "type system",
            "garbage collect",
            "distributed system",
            "consensus",
        ],
    ),
];

/// Specialists Ollama currently has pulled, matched by the `<domain>-specialist`
/// naming convention. Empty if Ollama is down or none are installed.
pub fn discover() -> Vec<Specialist> {
    let models = flux_agent::ollama::list_models();
    DOMAINS
        .iter()
        .filter_map(|(domain, label, _)| {
            let prefix = format!("{domain}-specialist");
            models
                .iter()
                .find(|m| m.to_ascii_lowercase().starts_with(&prefix))
                .map(|m| Specialist {
                    domain: domain.to_string(),
                    label: label.to_string(),
                    model: m.clone(),
                })
        })
        .collect()
}

/// Minimum distinct domain-term hits before routing — conservative so an
/// incidental "matrix" doesn't hijack a general question.
const ROUTE_THRESHOLD: usize = 2;

/// Pick the specialist whose domain the `query` most belongs to, if a specialist
/// for it is installed and the query clears the threshold. Pass the discovered set
/// in (callers often already have it) to avoid re-hitting Ollama.
pub fn route_with(query: &str, available: &[Specialist]) -> Option<Specialist> {
    if available.is_empty() {
        return None;
    }
    let q = query.to_ascii_lowercase();
    let mut best: Option<(usize, &Specialist)> = None;
    for (domain, _, kws) in DOMAINS {
        let Some(spec) = available.iter().find(|s| s.domain == *domain) else {
            continue;
        };
        let score = kws.iter().filter(|k| q.contains(**k)).count();
        if score >= ROUTE_THRESHOLD && best.map(|(b, _)| score > b).unwrap_or(true) {
            best = Some((score, spec));
        }
    }
    best.map(|(_, s)| s.clone())
}

/// Convenience: discover + route in one call.
pub fn route(query: &str) -> Option<Specialist> {
    route_with(query, &discover())
}

/// Command: list installed specialists (for the UI to show what's routable).
#[tauri::command]
pub async fn agent_specialists() -> Vec<Specialist> {
    tauri::async_runtime::spawn_blocking(discover)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specs() -> Vec<Specialist> {
        vec![Specialist {
            domain: "physics".into(),
            label: "Physics".into(),
            model: "physics-specialist:7b-council".into(),
        }]
    }

    #[test]
    fn routes_physics_questions_to_the_physics_specialist() {
        let r = route_with(
            "How does gravitational decoherence affect a qubit's wavefunction?",
            &specs(),
        );
        assert_eq!(r.unwrap().model, "physics-specialist:7b-council");
    }

    #[test]
    fn leaves_general_and_out_of_domain_questions_to_default() {
        // No specialist installed → never routes.
        assert!(route_with("Explain quantum entanglement and relativity", &[]).is_none());
        // One incidental term is below threshold.
        assert!(route_with("what's a good matrix-style movie?", &specs()).is_none());
        // Off-domain (math) with no math specialist installed → no route.
        assert!(route_with("prove the theorem by induction on the manifold", &specs()).is_none());
    }
}
